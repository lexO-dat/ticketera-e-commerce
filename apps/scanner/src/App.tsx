import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { ApiError, type CheckinResponse, type Session, api } from "./api";
import { startScanner } from "./camera";

const RESULT_TEXT: Record<
  CheckinResponse["result"],
  { title: string; tone: "ok" | "warn" | "bad" }
> = {
  ACCEPTED: { title: "Adelante", tone: "ok" },
  ALREADY_USED: { title: "Entrada ya usada", tone: "bad" },
  VOIDED: { title: "Entrada anulada", tone: "bad" },
  WRONG_EVENT: { title: "Es de otra función", tone: "warn" },
  INVALID: { title: "QR no válido", tone: "bad" },
};

/** Tras leer un QR, se ignora el mismo contenido unos segundos (la cámara lo ve en cada cuadro). */
const SAME_CODE_COOLDOWN_MS = 4000;

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  return session ? (
    <Door session={session} onSession={setSession} onLogout={() => setSession(null)} />
  ) : (
    <Login onLogin={setSession} />
  );
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(email.trim(), password));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Email o contraseña incorrectos"
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen center">
      <form className="card" onSubmit={(e) => void submit(e)}>
        <h1>Validación de entradas</h1>
        <p className="muted">Solo personal del evento (roles staff, organizer o admin).</p>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" disabled={busy}>
          {busy ? "Ingresando…" : "Ingresar"}
        </button>
      </form>
    </main>
  );
}

function Door({
  session,
  onSession,
  onLogout,
}: {
  session: Session;
  onSession: (session: Session) => void;
  onLogout: () => void;
}) {
  const [events, setEvents] = useState<{ slug: string; title: string }[]>([]);
  const [slug, setSlug] = useState("");
  const [dates, setDates] = useState<{ id: string; startsAt: string; venue: { name: string } }[]>(
    [],
  );
  const [dateId, setDateId] = useState("");
  const [gate, setGate] = useState("Acceso principal");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<CheckinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [stats, setStats] = useState<{ issued: number; checkedIn: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastCode = useRef<{ value: string; at: number } | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    api
      .events()
      .then((list) => setEvents(list.events))
      .catch(() => setEvents([]));
  }, []);

  useEffect(() => {
    if (!slug) return;
    api.event(slug).then((event) => {
      setDates(event.dates);
      setDateId(event.dates[0]?.id ?? "");
    });
  }, [slug]);

  /** Llama al gateway; si el token de acceso venció, lo renueva una vez. */
  const withToken = useCallback(
    async <T,>(call: (token: string) => Promise<T>): Promise<T> => {
      try {
        return await call(sessionRef.current.accessToken);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) throw err;
        const renewed = await api.refresh(sessionRef.current);
        onSession(renewed);
        sessionRef.current = renewed;
        return call(renewed.accessToken);
      }
    },
    [onSession],
  );

  const refreshStats = useCallback(() => {
    if (!dateId) return;
    withToken((token) => api.stats(token, dateId))
      .then(setStats)
      .catch(() => undefined);
  }, [dateId, withToken]);

  useEffect(() => {
    refreshStats();
    const timer = setInterval(refreshStats, 5000);
    return () => clearInterval(timer);
  }, [refreshStats]);

  const validate = useCallback(
    async (input: { qr?: string; code?: string }) => {
      if (!dateId) return;
      setError(null);
      try {
        const response = await withToken((token) =>
          api.checkin(token, { ...input, eventDateId: dateId, gate }),
        );
        setResult(response);
        navigator.vibrate?.(response.result === "ACCEPTED" ? 80 : [120, 60, 120]);
        refreshStats();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [dateId, gate, refreshStats, withToken],
  );

  useEffect(() => {
    if (!scanning || !videoRef.current) return;
    let stop: (() => void) | undefined;
    startScanner(videoRef.current, (value) => {
      const now = Date.now();
      if (
        lastCode.current &&
        lastCode.current.value === value &&
        now - lastCode.current.at < SAME_CODE_COOLDOWN_MS
      )
        return;
      lastCode.current = { value, at: now };
      void validate({ qr: value });
    })
      .then((stopper) => {
        stop = stopper;
      })
      .catch(() => {
        setError("No se pudo abrir la cámara. Revisa los permisos o usa el código manual.");
        setScanning(false);
      });
    return () => stop?.();
  }, [scanning, validate]);

  const tone = result ? RESULT_TEXT[result.result].tone : null;

  return (
    <main className="screen">
      <header className="bar">
        <strong>Ticketera · Puerta</strong>
        <span className="muted">{session.name}</span>
        <button className="link" onClick={onLogout}>
          Salir
        </button>
      </header>

      <section className="card grid">
        <label>
          Evento
          <select value={slug} onChange={(e) => setSlug(e.target.value)}>
            <option value="">Elige un evento</option>
            {events.map((event) => (
              <option key={event.slug} value={event.slug}>
                {event.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Función
          <select
            value={dateId}
            onChange={(e) => setDateId(e.target.value)}
            disabled={dates.length === 0}
          >
            {dates.map((date) => (
              <option key={date.id} value={date.id}>
                {new Date(date.startsAt).toLocaleString("es-CL")} · {date.venue.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Puerta
          <input value={gate} onChange={(e) => setGate(e.target.value)} maxLength={40} />
        </label>
        {stats ? (
          <p className="stats">
            Ingresados <strong>{stats.checkedIn}</strong> de {stats.issued}
          </p>
        ) : null}
      </section>

      {dateId ? (
        <>
          <section className={`result ${tone ?? "idle"}`} aria-live="assertive">
            {result ? (
              <>
                <h2>{RESULT_TEXT[result.result].title}</h2>
                {result.ticket ? (
                  <p>
                    {result.ticket.name}
                    {result.ticket.seatLabel ? ` · ${result.ticket.seatLabel}` : ""}
                    <br />
                    {result.ticket.holderName} · {result.ticket.code}
                  </p>
                ) : null}
                {result.result === "ALREADY_USED" && result.checkedInAt ? (
                  <p>Ingresó a las {new Date(result.checkedInAt).toLocaleTimeString("es-CL")}</p>
                ) : null}
              </>
            ) : (
              <h2>Listo para escanear</h2>
            )}
          </section>

          <section className="card grid">
            <video ref={videoRef} className={scanning ? "video" : "video hidden"} muted />
            <button onClick={() => setScanning((value) => !value)}>
              {scanning ? "Detener cámara" : "Escanear con la cámara"}
            </button>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (manual.trim()) void validate({ code: manual.trim() });
                setManual("");
              }}
            >
              <input
                placeholder="Código impreso (12 caracteres)"
                value={manual}
                onChange={(e) => setManual(e.target.value.toUpperCase())}
                maxLength={20}
                autoCapitalize="characters"
              />
              <button type="submit">Validar</button>
            </form>
            {error ? <p className="error">{error}</p> : null}
          </section>
        </>
      ) : null}
    </main>
  );
}
