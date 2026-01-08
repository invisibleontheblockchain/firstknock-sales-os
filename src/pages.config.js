import Sync from './pages/Sync';
import Home from './pages/Home';
import List from './pages/List';
import __Layout from './Layout.jsx';


export const PAGES = {
    "Sync": Sync,
    "Home": Home,
    "List": List,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};