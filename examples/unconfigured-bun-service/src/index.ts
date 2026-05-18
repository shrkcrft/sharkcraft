import { UserService } from './services/user.service.ts';
import { OrderService } from './services/order.service.ts';
import { hash } from './utils/hash.util.ts';

const users = new UserService();
const orders = new OrderService();

const id = users.create('alice');
const orderId = orders.place(id, ['book', 'pen']);
console.log(`user=${id} order=${orderId} sig=${hash(`${id}:${orderId}`)}`);
