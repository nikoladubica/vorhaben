import { app } from './app.js';
import { env } from './env.js';

app.listen(env.port, () => {
  console.log(`vorhaben server listening on http://localhost:${env.port}`);
});
