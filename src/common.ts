// sysexits.h: 64 = EX_USAGE, 77 = EX_NOPERM, 78 = EX_CONFIG
const EXIT: Record<string, number> = { EUSAGE: 64, EACCES: 77, EPERM: 77, ERR_ACCESS_DENIED: 77, ECONFIG: 78 };

export const exitCodeFor = (code?: string) => EXIT[code ?? ''] ?? 1;

export const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

export function checkWorkers(n: number) {
  if (!Number.isInteger(n) || n < 1 || n > 16) throw fail('ECONFIG', `workers must be an integer 1..16, got ${n}`);
}

export function log(level: 'info' | 'error', msg: string, extra: object = {}) {
  (level === 'error' ? console.error : console.log)(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));
}
