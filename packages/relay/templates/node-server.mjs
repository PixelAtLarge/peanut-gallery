// Plain Node: PEANUT_GALLERY_TOKEN=ghp_x PEANUT_GALLERY_REPO=owner/name node node-server.mjs
import { serve, optionsFromEnv } from '@peanut-gallery/relay/node';
serve(optionsFromEnv());
