import { notFound } from "next/navigation";
import { getProduct } from "@/lib/products/config";
import { formatCents } from "@/lib/products/pricing";
import { BookingWidget } from "./BookingWidget";

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = getProduct(slug);
  if (!product) notFound();

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <section className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight">{product.name}</h1>
        <p className="text-muted-foreground">{product.longDescription}</p>
        <div className="text-lg font-semibold">
          {formatCents(product.pricing.cents)}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            / {product.unit === "full-day" ? "day" : "hour"}
          </span>
        </div>
        <ul className="space-y-1 text-sm">
          {product.highlights.map((h) => (
            <li key={h}>· {h}</li>
          ))}
        </ul>
      </section>
      <BookingWidget product={product} />
    </div>
  );
}
