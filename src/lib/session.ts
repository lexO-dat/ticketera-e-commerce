const KEY = "ticketera.session";

export function getSessionToken(): string {
  if (typeof window === "undefined") return "ssr";
  let token = window.localStorage.getItem(KEY);
  if (!token) {
    token = crypto.randomUUID();
    window.localStorage.setItem(KEY, token);
  }
  return token;
}
