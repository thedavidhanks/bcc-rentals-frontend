import "server-only";
import { refundPaypalCapture } from "./paypal";

export async function refundPayment(input: {
  provider: "paypal";
  paymentRef: string;
  reason?: string;
}): Promise<void> {
  // PayPal paymentRef is a capture id.
  await refundPaypalCapture(input.paymentRef, input.reason);
}
