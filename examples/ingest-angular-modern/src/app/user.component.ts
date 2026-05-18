import { Component, ChangeDetectionStrategy } from '@angular/core';
import { userState } from './user.signal';

@Component({
  selector: 'app-user',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p>User: {{ user().name }}</p>`,
})
export class UserComponent {
  readonly user = userState;
}
