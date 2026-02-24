export function ok(data) {
  return { ok: true, data };
}

export function err(message, details, blocked, status) {
  const error = { message };
  if (details !== undefined) error.details = details;
  if (blocked !== undefined) error.blocked = blocked;
  if (status !== undefined) error.status = status;
  return { ok: false, error };
}

export function printJson(value) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(value, null, 2));
}
