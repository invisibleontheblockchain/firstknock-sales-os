/**
 * pages.config.js - Page routing configuration
 * 
 * This file is AUTO-GENERATED. Do not add imports or modify PAGES manually.
 * Pages are auto-registered when you create files in the ./pages/ folder.
 * 
 * THE ONLY EDITABLE VALUE: mainPage
 * This controls which page is the landing page (shown when users visit the app).
 * 
 * Example file structure:
 * 
 *   import HomePage from './pages/HomePage';
 *   import Dashboard from './pages/Dashboard';
 *   import Settings from './pages/Settings';
 *   
 *   export const PAGES = {
 *       "HomePage": HomePage,
 *       "Dashboard": Dashboard,
 *       "Settings": Settings,
 *   }
 *   
 *   export const pagesConfig = {
 *       mainPage: "HomePage",
 *       Pages: PAGES,
 *   };
 * 
 * Example with Layout (wraps all pages):
 *
 *   import Home from './pages/Home';
 *   import Settings from './pages/Settings';
 *   import __Layout from './Layout.jsx';
 *
 *   export const PAGES = {
 *       "Home": Home,
 *       "Settings": Settings,
 *   }
 *
 *   export const pagesConfig = {
 *       mainPage: "Home",
 *       Pages: PAGES,
 *       Layout: __Layout,
 *   };
 *
 * To change the main page from HomePage to Dashboard, use find_replace:
 *   Old: mainPage: "HomePage",
 *   New: mainPage: "Dashboard",
 *
 * The mainPage value must match a key in the PAGES object exactly.
 */
import DatabaseDiagnostic from './pages/DatabaseDiagnostic';
import Home from './pages/Home';
import List from './pages/List';
import RepHome from './pages/RepHome';
import Setup from './pages/Setup';
import SignIn from './pages/SignIn';
import Sync from './pages/Sync';
import AdminTeam from './pages/AdminTeam';
import ZipCodeExplorer from './pages/ZipCodeExplorer';
import Tutorial from './pages/Tutorial';
import RoleSelect from './pages/RoleSelect';
import __Layout from './Layout.jsx';


export const PAGES = {
    "DatabaseDiagnostic": DatabaseDiagnostic,
    "Home": Home,
    "List": List,
    "RepHome": RepHome,
    "Setup": Setup,
    "SignIn": SignIn,
    "Sync": Sync,
    "AdminTeam": AdminTeam,
    "ZipCodeExplorer": ZipCodeExplorer,
    "Tutorial": Tutorial,
    "RoleSelect": RoleSelect,
}

export const pagesConfig = {
    mainPage: "RoleSelect",
    Pages: PAGES,
    Layout: __Layout,
};