import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

/** Builds the configured app; main.ts listens on a port, serverless.ts hands requests to it. */
export async function createApp() {
  // The adapter is passed explicitly (rather than loaded by name) so bundlers trace it.
  // abortOnError: false makes a failed start throw (handled by the callers) instead of exiting.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, new ExpressAdapter(), { abortOnError: false });
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Behind a proxy (the Vite dev server, Vercel, a load balancer), take the visitor's IP from
  // X-Forwarded-For so rate limits apply per visitor, not per proxy. TRUST_PROXY in .env.example.
  app.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  // a coaster sent from the Coaster Workshop comes with its picture (up to 120 kB, as base64)
  app.useBodyParser('json', { limit: '400kb' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  // In dev and on Vercel the web app reaches the API on its own origin (/api); CORS covers
  // deployments where the two live on different origins.
  app.enableCors({ origin: config.get('WEB_ORIGIN', { infer: true }), credentials: true });
  return app;
}
