import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="space-y-4 py-16 text-center">
      <h1 className="text-3xl font-bold">Not found</h1>
      <p className="text-muted-foreground">That rental doesn&apos;t exist.</p>
      <Link href="/">
        <Button variant="outline">Back to rentals</Button>
      </Link>
    </div>
  );
}
