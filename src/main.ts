import { mount } from 'svelte';
// The eager module barrel. Importing it registers every module's codec and command table
// before anything can decode a document (invariant 7).
import './modules/codecs';
import App from './App.svelte';

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
