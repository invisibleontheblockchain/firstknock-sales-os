import { lazy } from 'react';
import __Layout from './Layout.jsx';

// Lazy load pages
const AdminTeam = lazy(() => import('./pages/AdminTeam'));
const Home = lazy(() => import('./pages/Home'));
const List = lazy(() => import('./pages/List'));
const Setup = lazy(() => import('./pages/Setup'));
const Sync = lazy(() => import('./pages/Sync'));

export const PAGES = {
    "AdminTeam": AdminTeam,
    "Home": Home,
    "List": List,
    "Setup": Setup,
    "Sync": Sync,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};