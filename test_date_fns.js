const { subMonths } = require('date-fns');
const d = new Date();
console.log("Date:", d);
console.log("subMonths 1:", subMonths(d, 1));
console.log("subMonths 0.25:", subMonths(d, 0.25));
