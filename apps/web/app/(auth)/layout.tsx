import type { ReactNode } from 'react';
import { AuthExperience } from './_components/AuthExperience';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthExperience>{children}</AuthExperience>;
}
