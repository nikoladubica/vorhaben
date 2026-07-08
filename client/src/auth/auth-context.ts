import { createContext } from 'react';

export type User = {
  id: number;
  email: string;
  base_currency: string;
  created_at?: string;
};

export type AuthState =
  { status: 'loading' } | { status: 'anonymous' } | { status: 'user'; user: User };

export type AuthContextValue = AuthState & {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, base_currency?: string) => Promise<void>;
  logout: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);
