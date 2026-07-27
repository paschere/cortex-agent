import { redirect } from 'next/navigation';

/**
 * The table, the tools and the weekly routine email all call these "growth
 * signals", so /growth is the address people will try. The page itself is called
 * Prospects because that is what it is to the person reading it — a list of
 * companies to approach, not a table of rows.
 */
export default function GrowthPage() {
  redirect('/prospects');
}
