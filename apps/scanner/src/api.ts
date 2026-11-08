/**
 * Cliente del gateway para la app de validación. Los tokens viven solo en memoria (se pierden al
 * cerrar la pestaña): es un dispositivo de personal, no hay cookies ni localStorage.
 */
export interface Session {
  accessToken: string;
  refreshToken: string;
  roles: string[];
  name: string;
}

export interface CheckinResponse {
  result: "ACCEPTED" | "ALREADY_USED" | "VOIDED" | "WRONG_EVENT" | "INVALID";
  ticket: {
    code: string;
    name: string;
    holderName: string;
    seatLabel: string | null;
    sectionName: string | null;
  } | null;
  checkedInAt: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const DOOR_ROLES = ["staff", "organizer", "admin"];

function rolesOf(accessToken: string): string[] {
  try {
    const payload = JSON.parse(
      atob(accessToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as {
      roles?: string[];
    };
    return payload.roles ?? [];
  } catch {
    return [];
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const response = await fetch(`/api${path}`, { ...init, headers });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new ApiError(
      response.status,
      String(body["detail"] ?? body["title"] ?? `Error ${response.status}`),
    );
  }
  return body as T;
}

export const api = {
  async login(email: string, password: string): Promise<Session> {
    const result = await request<{
      accessToken: string;
      refreshToken: string;
      user: { fullName: string };
    }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    const roles = rolesOf(result.accessToken);
    if (!roles.some((role) => DOOR_ROLES.includes(role))) {
      throw new ApiError(403, "Tu cuenta no tiene permiso para validar entradas");
    }
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      roles,
      name: result.user.fullName,
    };
  },

  async refresh(session: Session): Promise<Session> {
    const result = await request<{ accessToken: string; refreshToken: string }>("/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    return { ...session, accessToken: result.accessToken, refreshToken: result.refreshToken };
  },

  events: () =>
    request<{ events: { slug: string; title: string; nextDate: string | null }[] }>(
      "/catalog/events",
    ),

  event: (slug: string) =>
    request<{
      id: string;
      title: string;
      dates: { id: string; startsAt: string; venue: { name: string } }[];
    }>(`/catalog/events/${encodeURIComponent(slug)}`),

  checkin: (
    token: string,
    body: { qr?: string; code?: string; eventDateId: string; gate?: string },
  ) =>
    request<CheckinResponse>("/tickets/checkin", {
      method: "POST",
      body: JSON.stringify(body),
      token,
    }),

  stats: (token: string, dateId: string) =>
    request<{ issued: number; checkedIn: number }>(`/tickets/checkin/dates/${dateId}/stats`, {
      token,
    }),
};
