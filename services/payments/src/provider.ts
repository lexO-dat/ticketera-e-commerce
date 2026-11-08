import type { Logger } from "@shared/commons";

/**
 * Adapter del adquirente (ADR-07). El dominio de pagos solo conoce esta interfaz: pasar del mock a
 * Webpay real (u otro) es configuración + un adapter, sin tocar el servicio.
 */
export type ProviderStatus =
  "INITIALIZED" | "AUTHORIZED" | "FAILED" | "REVERSED" | "NULLIFIED" | "PARTIALLY_NULLIFIED";

export interface ProviderTransaction {
  status: ProviderStatus;
  responseCode: number | null;
  amount: number;
  buyOrder: string;
  authorizationCode: string | null;
  cardLast4: string | null;
  paymentType: string | null;
  /** Motivo de rechazo del mock (`UNSUPPORTED_TEST_EMAIL`), si lo hay. */
  reason: string | null;
}

export interface PaymentProvider {
  readonly name: string;
  create(input: {
    buyOrder: string;
    sessionId: string;
    amount: number;
    returnUrl: string;
    payerEmail: string;
  }): Promise<{ token: string; url: string }>;
  commit(token: string): Promise<ProviderTransaction>;
  status(token: string): Promise<ProviderTransaction>;
  refund(token: string, amount: number): Promise<{ type: string; balance: number }>;
}

/** Sin respuesta (timeout, 5xx, red): el resultado es incierto y se concilia con `status`. */
export class ProviderUnavailableError extends Error {
  override name = "ProviderUnavailableError";
}

/** El adquirente rechazó la operación por el estado de la transacción (p. ej. commit repetido). */
export class ProviderRejectedError extends Error {
  override name = "ProviderRejectedError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface WebpayTransactionBody {
  status: ProviderStatus;
  response_code: number | null;
  amount: number;
  buy_order: string;
  authorization_code: string | null;
  card_detail?: { card_number?: string };
  payment_type_code?: string;
  mock_reason?: string;
}

function toTransaction(body: WebpayTransactionBody): ProviderTransaction {
  return {
    status: body.status,
    responseCode: body.response_code,
    amount: body.amount,
    buyOrder: body.buy_order,
    authorizationCode: body.authorization_code,
    cardLast4: body.card_detail?.card_number?.slice(-4) ?? null,
    paymentType: body.payment_type_code ?? null,
    reason: body.mock_reason ?? null,
  };
}

/**
 * Webpay Plus REST v1.2 (Transbank). Con `mockPayerEmail` manda la cabecera de extensión que usa
 * webpay-mock para decidir; el adapter de producción la omite.
 */
export function createWebpayProvider(options: {
  baseUrl: string;
  apiKeyId: string;
  apiKeySecret: string;
  sendMockPayerEmail: boolean;
  timeoutMs?: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
}): PaymentProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = "/rswebpaytransaction/api/webpay/v1.2/transactions";

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(new URL(base + path, options.baseUrl), {
        method,
        headers: {
          "tbk-api-key-id": options.apiKeyId,
          "tbk-api-key-secret": options.apiKeySecret,
          // Sin cuerpo (commit / status) no se declara content-type: un JSON vacío es inválido.
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          accept: "application/json",
          ...extraHeaders,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
      });
    } catch (error) {
      throw new ProviderUnavailableError(error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    if (response.status >= 500)
      throw new ProviderUnavailableError(`adquirente respondió ${response.status}`);
    const parsed = (text ? JSON.parse(text) : {}) as T & { error_message?: string };
    if (!response.ok) {
      throw new ProviderRejectedError(
        response.status,
        parsed.error_message ?? `HTTP ${response.status}`,
      );
    }
    return parsed;
  }

  return {
    name: "webpay",
    create: (input) =>
      call<{ token: string; url: string }>(
        "POST",
        "",
        {
          buy_order: input.buyOrder,
          session_id: input.sessionId,
          amount: input.amount,
          return_url: input.returnUrl,
        },
        options.sendMockPayerEmail ? { "x-mock-payer-email": input.payerEmail } : {},
      ),
    commit: async (token) => toTransaction(await call<WebpayTransactionBody>("PUT", `/${token}`)),
    status: async (token) => toTransaction(await call<WebpayTransactionBody>("GET", `/${token}`)),
    refund: async (token, amount) => {
      const body = await call<{ type: string; balance: number }>("POST", `/${token}/refunds`, {
        amount,
      });
      return { type: body.type, balance: body.balance };
    },
  };
}
