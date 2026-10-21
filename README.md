# NetoAcademy

A Deriv bot trading site with a Node backend for OAuth and account WebSocket connections.

```sh
npm ci
npm run dev
```

Use Node 20 and `http://localhost:5000`. To build, run `npm run build`. For production, configure `NETO_ORIGIN` and a private `NETO_SESSION_SECRET`, then run `npm start`.

Deployment, application registration, bot compatibility and validation limits: [NETOACADEMY.md](NETOACADEMY.md). A Render Blueprint is provided in [render.yaml](render.yaml).
