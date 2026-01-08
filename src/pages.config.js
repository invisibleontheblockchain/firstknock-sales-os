import Home from './pages/Home';
import List from './pages/List';
import Routes from './pages/Routes';
import Sync from './pages/Sync';
import __Layout from './Layout.jsx';


export const PAGES = {
    "Home": Home,
    "List": List,
    "Routes": Routes,
    "Sync": Sync,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};