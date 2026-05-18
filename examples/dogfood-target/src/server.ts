import { UserService } from './services/user.service.ts';

const port = Number(process.env.PORT ?? 3000);
const userService = new UserService();
userService.init();

Bun.serve({
  port,
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname.startsWith('/users/')) {
      const id = url.pathname.slice('/users/'.length);
      const user = await userService.findById(id);
      if (!user) return new Response('not found', { status: 404 });
      return Response.json(user);
    }
    return new Response('not found', { status: 404 });
  },
});
