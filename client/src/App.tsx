import { useEffect, useState } from 'react';
import { getHealth, getVentures, type Venture } from './api';
import './App.css';

function App() {
  const [apiStatus, setApiStatus] = useState<'checking' | 'ok' | 'error'>('checking');
  const [ventures, setVentures] = useState<Venture[]>([]);

  useEffect(() => {
    getHealth()
      .then((health) => setApiStatus(health.status === 'ok' ? 'ok' : 'error'))
      .catch(() => setApiStatus('error'));

    getVentures()
      .then(setVentures)
      .catch(() => setVentures([]));
  }, []);

  return (
    <main className="app">
      <h1>vorhaben</h1>
      <p>Track your business endeavours.</p>
      <p className={`api-status api-status--${apiStatus}`}>API: {apiStatus}</p>

      <section>
        <h2>Ventures</h2>
        {ventures.length === 0 ? (
          <p>No ventures yet.</p>
        ) : (
          <ul>
            {ventures.map((venture) => (
              <li key={venture.id}>
                {venture.name} — <em>{venture.status}</em>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

export default App;
