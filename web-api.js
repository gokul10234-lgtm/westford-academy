const Auth = {
  getToken() { return localStorage.getItem('wsa_token'); },
  getUser() {
    try { return JSON.parse(localStorage.getItem('wsa_user') || 'null'); } catch (e) { return null; }
  },
  setSession({ token, username, role, trainerId, trainerActivity }) {
    localStorage.setItem('wsa_token', token);
    localStorage.setItem('wsa_user', JSON.stringify({ username, role, trainerId, trainerActivity }));
  },
  logout() {
    localStorage.removeItem('wsa_token');
    localStorage.removeItem('wsa_user');
    window.location.href = '/login.html';
  },
  requireLogin() {
    if (!this.getToken()) window.location.href = '/login.html';
  }
};

async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  const token = Auth.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined
  });

  if (res.status === 401) {
    Auth.logout();
    throw new Error('Session expired. Please log in again.');
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : await res.blob();

  if (!res.ok) {
    const msg = (data && data.error) ? data.error : 'Request failed.';
    throw new Error(msg);
  }
  return data;
}
