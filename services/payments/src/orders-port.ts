import type { ServiceClient } from "@shared/commons/http";
import type { OrderForPayment, OrdersPort } from "./service.js";

/** Lee la orden en `orders` (endpoint interno): el monto nunca viene del cliente. */
export function createOrdersPort(client: ServiceClient): OrdersPort {
  return {
    async getForPayment(orderId) {
      const response = await client.request<OrderForPayment>("GET", `/internal/orders/${orderId}`);
      return response.body;
    },
  };
}
