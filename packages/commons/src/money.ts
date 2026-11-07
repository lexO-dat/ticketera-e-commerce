/**
 * Dinero en pesos chilenos (CLP, sin decimales) representado como `bigint`.
 * Nunca usar `number` con decimales ni floats para montos: los totales se calculan en el servidor.
 */

declare const clpBrand: unique symbol;
export type CLP = bigint & { readonly [clpBrand]: true };

export const ZERO_CLP = 0n as CLP;

export function clp(value: bigint | number | string): CLP {
  let amount: bigint;
  if (typeof value === "bigint") {
    amount = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError(`Monto CLP inválido: ${value}`);
    amount = BigInt(value);
  } else {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) throw new RangeError(`Monto CLP inválido: ${value}`);
    amount = BigInt(trimmed);
  }
  return amount as CLP;
}

export function nonNegativeClp(value: bigint | number | string): CLP {
  const amount = clp(value);
  if (amount < 0n) throw new RangeError("El monto no puede ser negativo");
  return amount;
}

export function addClp(...amounts: CLP[]): CLP {
  return amounts.reduce<bigint>((total, amount) => total + amount, 0n) as CLP;
}

export function subtractClp(a: CLP, b: CLP): CLP {
  return (a - b) as CLP;
}

export function multiplyClp(amount: CLP, quantity: number | bigint): CLP {
  if (typeof quantity === "number" && !Number.isSafeInteger(quantity)) {
    throw new RangeError("La cantidad debe ser un entero");
  }
  return (amount * BigInt(quantity)) as CLP;
}

/** Porcentaje en puntos básicos (1 % = 100 pb), redondeo half-up (alejándose de cero) al peso. */
export function percentOfClp(amount: CLP, basisPoints: number): CLP {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError("Los puntos básicos deben ser un entero no negativo");
  }
  const numerator = amount * BigInt(basisPoints);
  const sign = numerator < 0n ? -1n : 1n;
  return ((sign * (numerator * sign + 5_000n)) / 10_000n) as CLP;
}

const formatter = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

export function formatClp(amount: CLP): string {
  return formatter.format(amount);
}

/** Serializa para JSON (los `bigint` no son serializables por defecto): string decimal. */
export function clpToJson(amount: CLP): string {
  return amount.toString();
}
