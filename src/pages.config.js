import Home from './pages/Home';
import List from './pages/List';
import Setup from './pages/Setup';
import Sync from './pages/Sync';
import AdminTeam from './pages/AdminTeam';
import __Layout from './Layout.jsx';


export const PAGES = {
    "Home": Home,
    "List": List,
    "Setup": Setup,
    "Sync": Sync,
    "AdminTeam": AdminTeam,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};