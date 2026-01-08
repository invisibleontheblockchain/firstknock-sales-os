import Home from './pages/Home';
import List from './pages/List';
import Sync from './pages/Sync';
import Setup from './pages/Setup';
import __Layout from './Layout.jsx';


export const PAGES = {
    "Home": Home,
    "List": List,
    "Sync": Sync,
    "Setup": Setup,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};