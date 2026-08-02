/* 與後端溝通的薄封裝 */
const API = (() => {
  const TOKEN_KEY = 'ielts_token';
  const USER_KEY = 'ielts_user';

  let token = localStorage.getItem(TOKEN_KEY) || '';
  let user = null;
  try { user = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { user = null; }

  function setSession(t, u) {
    token = t || '';
    user = u || null;
    if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u)); else localStorage.removeItem(USER_KEY);
  }

  async function req(method, path, body, opts = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload = body;
    if (body && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    /* 一定要有逾時。
       整個前端以前沒有任何一個地方設過，而 fetch 預設是「等到天荒地老」。
       校園 Wi-Fi 漫遊、captive portal 這種「TCP 通但沒有回應」的狀態下，
       await 永遠不會回來 —— 學生按下交卷之後畫面一片死寂，沒有轉圈、
       沒有錯誤、按鈕也沒有變灰，只能一直重按。
       AI 批改那類本來就慢的請求可以自己放寬 opts.timeout。 */
    const ms = opts.timeout ?? (path.startsWith('/ai/') ? 180000 : 25000);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    let res;
    try {
      res = await fetch(`/api${path}`, { method, headers, body: payload, signal: ctl.signal });
    } catch (e) {
      if (e.name === 'AbortError') {
        const err = new Error(`伺服器在 ${Math.round(ms / 1000)} 秒內沒有回應，請檢查網路`);
        err.timeout = true;
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    // 401 有兩種完全不同的情況，不能混為一談：
    //   1. 登入請求本身失敗 → 是帳號密碼錯，要把伺服器的原始訊息顯示出來
    //   2. 其他請求的 token 失效 → 才是「登入已過期」，需要導回登入頁
    const isLoginRequest = path === '/auth/login';
    if (res.status === 401 && !isLoginRequest) {
      const hadToken = !!token;
      setSession('', null);
      // 本來就沒 token（例如已經在登入頁）就不要再導轉，
      // 否則 hashchange 會重新渲染登入頁，把錯誤訊息和已輸入的帳密一起洗掉
      if (hadToken && !location.hash.startsWith('#/login')) location.hash = '#/login';
      throw new Error('登入已過期，請重新登入');
    }
    if (opts.raw) {
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      return res;
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json().catch(() => ({})) : { text: await res.text() };
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.details = data;
      throw err;
    }
    return data;
  }

  return {
    get token() { return token; },
    get user() { return user; },
    setSession,
    get: (p, o) => req('GET', p, null, o),
    post: (p, b, o) => req('POST', p, b, o),
    put: (p, b) => req('PUT', p, b),
    del: (p) => req('DELETE', p),
    logout() { setSession('', null); location.hash = '#/login'; },
  };
})();
