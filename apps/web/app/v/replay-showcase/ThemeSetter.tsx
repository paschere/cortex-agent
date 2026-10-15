'use client';

import { useEffect } from 'react';

export function ThemeSetter({ dark }: { dark: boolean }) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return null;
}
