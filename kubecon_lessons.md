Key learnings and industry trends
Gaining momentum: Sandboxing on pod based VMs (gVisor, microVM, Kata) and GPU segmentation via Dynamic Resource Allocation (DRA), easier setup of Kubernetes clusters via new tooling that automates cluster setup via config and new APIs.
 * Using pod-based VMs requires either bare-metal hosts or some sort of hypervisor pass-through on your existing hypervisor. In AWS terms this would be hosts with ".metal"
Problems others are solving: 
What surprised me: The number of people at the conference who were CEOs and other industry leaders

Immediate action items
Right away: Demonstrate capabilities of DRA to programs that have heavy GPU utilization, demonstrate new platform capabilities and APIs that allow programs to more easily stand up cluster infrastructure.
KNative fits Maestro's use-case well as long as events are HTTP driven (POST required to trigger jobs),
k0s fits Phobos needs for quick and easy dev cluster provisioning on CorpNET hardware. Possible IT DevOps team uses.
Plan to implement: Via demonstration to program stakeholders 

Overall conference
Worked well: Not spending the entire time on the solutions showcase floor. Having conversations with industry leaders in a variety of areas. Carefully selecting talks with baked-in down time allowed room for networking with other industry leaders to explore practical solutions vice talks and solution showroom sales persons who are just trying to push their products without practical necessity.
Areas for improvement: Slides posted late for some talks; some sessions were product pitches.
Top talks worth sharing:
* k0s, CAPI (Cluster API for provisioning Clusters as first-class citizens in k8s with k0s)
* sandboxing (Kata, microVM, etc.)
* data analytics platforms by the MLB (KNative for batch processing) KNative for AWS Lambda-like functionality in EKS.
* Betting the Data Platform on Kubernetes  (Python Ray, Apache Volcano, Apache YuniKorn) presented by Apple, AirBnB, Instagram
* Open Policy Agent Rego Runtime Compiler with Java presented by Google.
* DRA, GPU segmentation technology stacks like NVIDIA MIG
Takeaway: explained above.
Relevance: explained above.