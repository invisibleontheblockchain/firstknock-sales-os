import AdminTeam from './pages/AdminTeam';
import DatabaseDiagnostic from './pages/DatabaseDiagnostic';
import Home from './pages/Home';
import List from './pages/List';
import RepHome from './pages/RepHome';
import RoleSelect from './pages/RoleSelect';
import Setup from './pages/Setup';
import SignIn from './pages/SignIn';
import Sync from './pages/Sync';
import Tutorial from './pages/Tutorial';
import ZipCodeExplorer from './pages/ZipCodeExplorer';
import __Layout from './Layout.jsx';


export const PAGES = {
    "AdminTeam": AdminTeam,
    "DatabaseDiagnostic": DatabaseDiagnostic,
    "Home": Home,
    "List": List,
    "RepHome": RepHome,
    "RoleSelect": RoleSelect,
    "Setup": Setup,
    "SignIn": SignIn,
    "Sync": Sync,
    "Tutorial": Tutorial,
    "ZipCodeExplorer": ZipCodeExplorer,
}

export const pagesConfig = {
    mainPage: "RoleSelect",
    Pages: PAGES,
    Layout: __Layout,
};