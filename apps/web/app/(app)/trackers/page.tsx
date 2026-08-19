import { redirect } from 'next/navigation';

/**
 * Las tablas inventadas viven en el chat, fijadas al lado. Esta ruta existe
 * para que «Ver todo» y el destino de «Todo» no 404: abre el marco sobre la
 * conversación, que es donde se leen.
 */
export default function TrackersPage() {
  redirect('/chat?panel=trackers');
}
