import AdminTeam from './pages/AdminTeam';
import Home from './pages/Home';
import List from './pages/List';
import Setup from './pages/Setup';
import Sync from './pages/Sync';
import Tutorial from './pages/Tutorial';
import RepHome from './pages/RepHome';
import RoleSelect from './pages/RoleSelect';
import __Layout from './Layout.jsx';


export const PAGES = {
    "AdminTeam": AdminTeam,
    "Home": Home,
    "List": List,
    "Setup": Setup,
    "Sync": Sync,
    "Tutorial": Tutorial,
    "RepHome": RepHome,
    "RoleSelect": RoleSelect,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};