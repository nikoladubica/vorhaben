export interface Venture {
  id: number;
  name: string;
  description: string | null;
  status: 'idea' | 'active' | 'paused' | 'archived';
  created_at: string;
  updated_at: string;
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) {
    throw new Error(`Request to ${path} failed with ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function getHealth() {
  return request<{ status: string; db: string }>('/health');
}

export function getVentures() {
  return request<Venture[]>('/ventures');
}
