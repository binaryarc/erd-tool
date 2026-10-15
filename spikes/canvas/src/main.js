import { createApp } from 'vue';
import App from './App.vue';
import SqlEditor from './SqlEditor.vue';

// #sql 이면 Monaco 시험 화면, 아니면 ERD 캔버스 시험 화면
createApp(location.hash === '#sql' ? SqlEditor : App).mount('#app');
