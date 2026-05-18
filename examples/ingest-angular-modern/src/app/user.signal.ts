import { signal, computed } from '@angular/core';

export const userState = signal({ id: '', name: '' });
export const greeting = computed(() => `Hello, ${userState().name}`);
