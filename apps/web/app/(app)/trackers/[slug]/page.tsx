import { redirect } from 'next/navigation';

export default async function TrackerPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const key = encodeURIComponent(slug.trim());
  redirect(`/chat?panel=tracker&key=${key}`);
}
