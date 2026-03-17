import { Base44Client } from '@base44/sdk';
const base44 = new Base44Client({ appId: "695eb764b077190880be21de", appBaseUrl: "https://my-to-do-list-81bfaad7.base44.app" });
async function run() {
    try {
        const jobs = await base44.asServiceRole.entities.FetchJob.filter({}, "-created_date", 2);
        const jobList = Array.isArray(jobs) ? jobs : (jobs?.items || []);
        if (jobList.length > 0) {
            console.log("LATEST JOB LOGS:");
            console.log(JSON.stringify(jobList[0].error_log, null, 2));
            console.log("\nJOB STATUS:", jobList[0].status);
            console.log("JOB TOTAL FETCHED:", jobList[0].total_fetched);
            console.log("JOB RADIUS:", jobList[0].radius);
            console.log("JOB SUB_CIRCLES:", jobList[0].sub_circles ? jobList[0].sub_circles.length : 0);
            
            console.log("\nPREVIOUS JOB:");
            console.log("STATUS:", jobList[1].status);
            console.log("TOTAL FETCHED:", jobList[1].total_fetched);
        }
    } catch (e) { console.error(e); }
}
run();
