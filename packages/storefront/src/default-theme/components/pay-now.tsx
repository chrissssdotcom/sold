'use client';

import { useEffect, useState } from 'react';

export function PayInstructions({ token }: { token: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(sessionStorage.getItem(`sold_pay_${token.slice(0, 8)}`));
  }, [token]);
  if (!text) return null;
  return (
    <div className="notice" role="note">
      <strong>How to pay</strong>
      <p style={{ marginTop: '0.25rem' }}>{text}</p>
    </div>
  );
}
