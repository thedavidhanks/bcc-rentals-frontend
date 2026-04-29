import { format, parseISO } from "date-fns";

type Args = {
  customerName: string;
  productName: string;
  startISO: string;
  endISO: string;
  totalFormatted: string;
  referenceNumber: string;
  orderId: string;
};

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderConfirmationHtml(args: Args): string {
  const start = format(parseISO(args.startISO), "EEEE, MMMM d, yyyy 'at' h:mm a");
  const end = format(parseISO(args.endISO), "EEEE, MMMM d, yyyy 'at' h:mm a");
  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
    <h1 style="font-size: 22px; margin-bottom: 8px;">Your rental is confirmed</h1>
    <p>Hi ${escape(args.customerName)},</p>
    <p>Thanks for renting from the Bachman Community Center. Here are your details:</p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr><td style="padding: 6px 0;"><strong>Item</strong></td><td>${escape(args.productName)}</td></tr>
      <tr><td style="padding: 6px 0;"><strong>From</strong></td><td>${escape(start)}</td></tr>
      <tr><td style="padding: 6px 0;"><strong>Until</strong></td><td>${escape(end)}</td></tr>
      <tr><td style="padding: 6px 0;"><strong>Total paid</strong></td><td>${escape(args.totalFormatted)}</td></tr>
      <tr><td style="padding: 6px 0;"><strong>Reference</strong></td><td>${escape(args.referenceNumber)}</td></tr>
      <tr><td style="padding: 6px 0;"><strong>Order ID</strong></td><td>${escape(args.orderId)}</td></tr>
    </table>
    <p>If you need to change or cancel, reply to this email or contact <a href="mailto:reservations@bachmancc.org">reservations@bachmancc.org</a>.</p>
    <p style="color: #666; font-size: 12px; margin-top: 32px;">Bachman Community Center · Walden, TN · <a href="https://bachmancc.org">bachmancc.org</a></p>
  </body>
</html>`;
}
