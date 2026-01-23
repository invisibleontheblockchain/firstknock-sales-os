import AdminTeam from './pages/AdminTeam';
import Home from './pages/Home';
import List from './pages/List';
import Setup from './pages/Setup';
import Sync from './pages/Sync';
import Tutorial from './pages/Tutorial';
import __Layout from './Layout.jsx';


export const PAGES = {
    "AdminTeam": AdminTeam,
    "Home": Home,
    "List": List,
    "Setup": Setup,
    "Sync": Sync,
    "Tutorial": Tutorial,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};