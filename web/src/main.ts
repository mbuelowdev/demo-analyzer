import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import 'uplot/dist/uPlot.min.css';

mount(App, { target: document.getElementById('app')! });
