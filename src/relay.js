// relay/worker.js 대기열에 쌓인 요청을 수집기가 가져갑니다.
export function createRelayClient({ url, readKey }) {
  const request = async (path, options = {}) => {
    const response = await fetch(`${url}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${readKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`중계 서버 응답 ${response.status}`);
    return response.json();
  };

  return {
    list: async () => (await request('/queue')).items,
    remove: (id) => request(`/queue/${id}`, { method: 'DELETE' }),
  };
}
