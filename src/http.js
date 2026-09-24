// Shared response helpers, so the worker and the accounts module agree on shape.

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
