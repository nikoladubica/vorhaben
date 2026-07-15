import { createContext } from 'react';

export type User = {
  id: number;
  email: string;
  base_currency: string;
  // Onboarding preference (design screen "03"): track hours vs. revenue-only. Server default true.
  track_hours: boolean;
  created_at?: string;
};

export type AuthState =
  { status: 'loading' } | { status: 'anonymous' } | { status: 'user'; user: User };

export type AuthContextValue = AuthState & {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, base_currency?: string) => Promise<void>;
  logout: () => Promise<void>;
  // Reflect a server-confirmed change to the signed-in user (e.g. base currency) in the session
  // state without a full re-fetch. A no-op unless the current status is `user`.
  updateUser: (user: User) => void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);
