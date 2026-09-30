/**
 * Machine-readable error codes the checkout flow's clients branch on (see
 * docs/CHECKOUT_ORDER_FLOW.md §C). Generic codes stay the default for every
 * factory below; the specific ones are passed explicitly where a client
 * needs to react differently (e.g. `price_changed` re-shows the review
 * step, `out_of_stock` offers "reduce quantity").
 */
export type ApiErrorCode =
  | "bad_request"
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "gone"
  | "unprocessable"
  | "rate_limited"
  | "bad_gateway"
  | "internal_error"
  | "cart_empty"
  | "cart_invalid"
  | "product_unavailable"
  | "variant_unavailable"
  | "out_of_stock"
  | "quantity_limit"
  | "rental_date_invalid"
  | "price_changed"
  | "coupon_invalid"
  | "address_invalid"
  | "delivery_unavailable"
  | "order_expired"
  | "order_not_payable"
  | "idempotency_conflict"
  | "payment_verification_failed"
  | "payment_processing";

export class ApiError extends Error {
  status: number;
  code: ApiErrorCode;
  details?: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown, code: ApiErrorCode = "bad_request") {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(message = "Authentication required") {
    return new ApiError(401, "unauthorized", message);
  }
  static forbidden(message = "You do not have access to this resource", details?: unknown) {
    return new ApiError(403, "forbidden", message, details);
  }
  static notFound(message = "Not found", code: ApiErrorCode = "not_found") {
    return new ApiError(404, code, message);
  }
  static conflict(message: string, details?: unknown, code: ApiErrorCode = "conflict") {
    return new ApiError(409, code, message, details);
  }
  static gone(message: string, details?: unknown, code: ApiErrorCode = "gone") {
    return new ApiError(410, code, message, details);
  }
  static unprocessable(message: string, details?: unknown, code: ApiErrorCode = "unprocessable") {
    return new ApiError(422, code, message, details);
  }
  static tooManyRequests(message = "Too many requests") {
    return new ApiError(429, "rate_limited", message);
  }
  static badGateway(message: string, details?: unknown, code: ApiErrorCode = "bad_gateway") {
    return new ApiError(502, code, message, details);
  }
}
