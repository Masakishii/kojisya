/**
 * 現場測量・記録野帳 ＆ 工事写真台帳 共通同期API（Cloudflare Workers用）
 * バインディング変数:
 *   - env.DB     : D1 SQLite Database (genba-db)
 *   - env.BUCKET : R2 Object Storage (genba-storage)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Site-Key'
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS
    }
  });
}

function getSiteKey(request, url) {
  return (
    request.headers.get('X-Site-Key') ||
    url.searchParams.get('site_key') ||
    ''
  ).trim();
}

export default {
  async fetch(request, env) {
    // プリフライト（CORS）応答
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 1. 接続テスト・ヘルスチェック
      if (path === '/' || path === '/api/ping') {
        const siteKey = getSiteKey(request, url);
        let siteInfo = null;
        if (siteKey && env.DB) {
          siteInfo = await env.DB.prepare(
            'SELECT site_key, site_name, contractor, created_at FROM sites WHERE site_key = ?'
          ).bind(siteKey).first();
        }
        return jsonResponse({
          ok: true,
          service: 'genba-sync-api',
          version: '2026-11-22-media-delete',
          message: 'Cloudflare Workers 共通同期サーバーは正常に稼働しています',
          dbConnected: !!env.DB,
          r2Connected: !!env.BUCKET,
          siteVerified: !!siteInfo,
          site: siteInfo
        });
      }

      // 2. R2ストレージ内の画像・豆図ファイルの直接配信
      if (path.startsWith('/api/media/file/')) {
        if (!env.BUCKET) {
          return jsonResponse({ ok: false, error: 'R2ストレージ(BUCKET)が未接続です' }, 500);
        }
        const storageKey = decodeURIComponent(path.replace('/api/media/file/', ''));
        const obj = await env.BUCKET.get(storageKey);
        if (!obj) {
          return new Response('File Not Found', { status: 404, headers: CORS_HEADERS });
        }
        const headers = new Headers(CORS_HEADERS);
        obj.writeHttpMetadata(headers);
        if (!headers.get('Content-Type')) {
          headers.set('Content-Type', storageKey.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg');
        }
        headers.set('Cache-Control', 'public, max-age=31536000');
        return new Response(obj.body, { headers });
      }

      // 3. 新規現場キーの作成・登録（または既存現場の情報更新）
      if (path === '/api/sites/register' && request.method === 'POST') {
        const body = await request.json();
        const siteKey = String(body.site_key || '').trim();
        const siteName = String(body.site_name || '新規現場プロジェクト').trim();
        const contractor = String(body.contractor || '').trim();

        if (!siteKey || siteKey.length < 4) {
          return jsonResponse({ ok: false, error: '現場キーは4文字以上で指定してください' }, 400);
        }

        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO sites (site_key, site_name, contractor, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(site_key) DO UPDATE SET
             site_name = excluded.site_name,
             contractor = excluded.contractor`
        ).bind(siteKey, siteName, contractor, now).run();

        return jsonResponse({
          ok: true,
          site: { site_key: siteKey, site_name: siteName, contractor, created_at: now }
        });
      }

      // これ以降のAPIは「現場キー（X-Site-Key）」必須
      const siteKey = getSiteKey(request, url);
      if (!siteKey) {
        return jsonResponse({ ok: false, error: '現場キー（X-Site-Key）が指定されていません' }, 401);
      }

      const siteRow = await env.DB.prepare(
        'SELECT site_key, site_name, contractor FROM sites WHERE site_key = ?'
      ).bind(siteKey).first();

      if (!siteRow) {
        return jsonResponse({ ok: false, error: '無効な現場キーです（登録されていません）' }, 403);
      }

      // 4. 共通写真・豆図プールの一覧取得
      if (path === '/api/media' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM shared_media WHERE site_key = ? ORDER BY created_at DESC LIMIT 200'
        ).bind(siteKey).all();
        return jsonResponse({ ok: true, site: siteRow, media: results || [] });
      }

      // 5. 写真・豆図のアップロード（R2へ保存し、D1のshared_mediaへ記録）
      if (path === '/api/media/upload' && request.method === 'POST') {
        if (!env.BUCKET) {
          return jsonResponse({ ok: false, error: 'R2ストレージ(BUCKET)が未設定です' }, 500);
        }

        const formData = await request.formData();
        const file = formData.get('file');
        const mediaType = String(formData.get('media_type') || 'photo');
        const mediaId = String(formData.get('media_id') || `med_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
        const takenAt = String(formData.get('taken_at') || '');
        const uploadedBy = String(formData.get('uploaded_by') || '');

        if (!file || typeof file === 'string') {
          return jsonResponse({ ok: false, error: 'アップロードファイルがありません' }, 400);
        }

        const ext = mediaType === 'mamezu' && file.type === 'image/svg+xml' ? 'svg' : 'jpg';
        const folder = mediaType === 'mamezu' ? 'mamezu' : 'photos';
        const storageKey = `${siteKey}/${folder}/${mediaId}.${ext}`;

        await env.BUCKET.put(storageKey, await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type || 'image/jpeg' }
        });

        const publicFileUrl = `${url.origin}/api/media/file/${encodeURIComponent(storageKey)}`;
        const now = Date.now();

        await env.DB.prepare(
          `INSERT INTO shared_media (media_id, site_key, media_type, storage_key, storage_url, taken_at, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(media_id) DO UPDATE SET
             storage_key = excluded.storage_key,
             storage_url = excluded.storage_url,
             taken_at = excluded.taken_at`
        ).bind(mediaId, siteKey, mediaType, storageKey, publicFileUrl, takenAt, uploadedBy, now).run();

        return jsonResponse({
          ok: true,
          media: {
            media_id: mediaId,
            site_key: siteKey,
            media_type: mediaType,
            storage_key: storageKey,
            storage_url: publicFileUrl,
            taken_at: takenAt,
            created_at: now
          }
        });
      }

      // 5-2. 不要な写真・豆図の削除（R2実体ファイル ＋ D1 shared_media 削除）
      if (
        (path === '/api/media/delete' && request.method === 'POST') ||
        (path.startsWith('/api/media/') && request.method === 'DELETE')
      ) {
        let targetIds = [];
        if (request.method === 'DELETE') {
          const idFromPath = decodeURIComponent(path.replace('/api/media/', '')).trim();
          if (idFromPath) targetIds = [idFromPath];
        } else {
          const body = await request.json();
          if (Array.isArray(body.media_ids)) {
            targetIds = body.media_ids.map(x => String(x || '').trim()).filter(Boolean);
          } else if (body.media_id) {
            targetIds = [String(body.media_id).trim()];
          }
        }

        if (targetIds.length === 0) {
          return jsonResponse({ ok: false, error: '削除対象の media_id が指定されていません' }, 400);
        }

        let deletedCount = 0;
        const deletedIds = [];

        for (const mId of targetIds) {
          const row = await env.DB.prepare(
            'SELECT media_id, storage_key, original_key FROM shared_media WHERE site_key = ? AND media_id = ?'
          ).bind(siteKey, mId).first();

          if (row) {
            if (env.BUCKET) {
              if (row.storage_key) {
                try { await env.BUCKET.delete(row.storage_key); } catch (_) {}
              }
              if (row.original_key) {
                try { await env.BUCKET.delete(row.original_key); } catch (_) {}
              }
            }

            await env.DB.batch([
              env.DB.prepare('DELETE FROM shared_media WHERE site_key = ? AND media_id = ?').bind(siteKey, mId),
              env.DB.prepare("UPDATE ledger_items SET media_id = '' WHERE site_key = ? AND media_id = ?").bind(siteKey, mId),
              env.DB.prepare("UPDATE ledger_items SET mamezu_media_id = '' WHERE site_key = ? AND mamezu_media_id = ?").bind(siteKey, mId)
            ]);

            deletedCount++;
            deletedIds.push(mId);
          }
        }

        return jsonResponse({
          ok: true,
          deletedCount,
          deletedIds
        });
      }

      // 6. 工事写真台帳データの取得・同期保存
      if (path === '/api/ledger' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM ledger_items WHERE site_key = ? ORDER BY sort_order ASC, updated_at ASC'
        ).bind(siteKey).all();
        return jsonResponse({ ok: true, site: siteRow, items: results || [] });
      }

      if (path === '/api/ledger/sync' && request.method === 'POST') {
        const body = await request.json();
        const items = Array.isArray(body.items) ? body.items : [];
        const now = Date.now();

        const stmts = [
          env.DB.prepare('DELETE FROM ledger_items WHERE site_key = ?').bind(siteKey)
        ];

        items.forEach((it, idx) => {
          stmts.push(
            env.DB.prepare(
              `INSERT INTO ledger_items (
                item_id, site_key, sort_order, source_type, pin_label, phase_label,
                media_id, mamezu_media_id, work_type, location, photo_date, comment,
                chalkboard_json, pin_ref, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              String(it.item_id || `item_${now}_${idx}`),
              siteKey,
              idx,
              String(it.source_type || 'standalone'),
              String(it.pin_label || ''),
              String(it.phase_label || ''),
              String(it.media_id || ''),
              String(it.mamezu_media_id || ''),
              String(it.work_type || ''),
              String(it.location || ''),
              String(it.photo_date || ''),
              String(it.comment || ''),
              typeof it.chalkboard_json === 'string' ? it.chalkboard_json : JSON.stringify(it.chalkboard_json || {}),
              String(it.pin_ref || ''),
              now
            )
          );
        });

        await env.DB.batch(stmts);
        return jsonResponse({ ok: true, syncedCount: items.length, updatedAt: now });
      }

      // 7. 測量野帳データの取得・同期保存
      if (path === '/api/fieldnote' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM fieldnote_pages WHERE site_key = ? ORDER BY notebook_id ASC, page_order ASC'
        ).bind(siteKey).all();
        return jsonResponse({ ok: true, site: siteRow, pages: results || [] });
      }

      if (path === '/api/fieldnote/sync' && request.method === 'POST') {
        const body = await request.json();
        const pages = Array.isArray(body.pages) ? body.pages : [];
        const now = Date.now();

        const stmts = [
          env.DB.prepare('DELETE FROM fieldnote_pages WHERE site_key = ?').bind(siteKey)
        ];

        pages.forEach((pg, idx) => {
          stmts.push(
            env.DB.prepare(
              `INSERT INTO fieldnote_pages (
                page_id, site_key, notebook_id, notebook_name, page_order,
                title, paper_format, page_json, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              String(pg.page_id || `page_${now}_${idx}`),
              siteKey,
              String(pg.notebook_id || 'nb_default'),
              String(pg.notebook_name || '現場測量・記録野帳'),
              idx,
              String(pg.title || ''),
              String(pg.paper_format || 'yaecho-spread'),
              typeof pg.page_json === 'string' ? pg.page_json : JSON.stringify(pg.page_json || {}),
              now
            )
          );
        });

        await env.DB.batch(stmts);
        return jsonResponse({ ok: true, syncedCount: pages.length, updatedAt: now });
      }

      return jsonResponse({ ok: false, error: '未定義のAPIパスです' }, 404);
    } catch (err) {
      return jsonResponse({ ok: false, error: err?.message || 'サーバー内部エラー' }, 500);
    }
  }
};