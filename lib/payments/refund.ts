import "server-only";
import { getStripe } from "./stripe";
import { refundPaypalCapture } from "./paypal";

export async function refundPayment(input: {
  provider: "stripe" | "paypal";
  paymentRef: string;
  reason?: string;
}): Promise<void> {
  if (input.provider === "stripe") {
    // paymentRef is a PaymentIntent id (pi_...).
    await getStripe().refunds.create({ payment_intent: input.paymentRef });
    return;
  }
  // PayPal paymentRef is a capture id.
  await refundPaypalCapture(input.paymentRef, input.reason);
}
