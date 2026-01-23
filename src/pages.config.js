import AdminTeam from './pages/AdminTeam';
import Home from './pages/Home';
import List from './pages/List';
import RoleSelect from './pages/RoleSelect';
import Setup from './pages/Setup';
import Sync from './pages/Sync';
import Tutorial from './pages/Tutorial';
import RepHome from './pages/RepHome';
import __Layout from './Layout.jsx';


export const PAGES = {
    "AdminTeam": AdminTeam,
    "Home": Home,
    "List": List,
    "RoleSelect": RoleSelect,
    "Setup": Setup,
    "Sync": Sync,
    "Tutorial": Tutorial,
    "RepHome": RepHome,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};