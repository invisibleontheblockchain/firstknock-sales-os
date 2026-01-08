import Home from './pages/Home';
import List from './pages/List';
import Sync from './pages/Sync';
import Routes from './pages/Routes';
import __Layout from './Layout.jsx';


export const PAGES = {
    "Home": Home,
    "List": List,
    "Sync": Sync,
    "Routes": Routes,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};